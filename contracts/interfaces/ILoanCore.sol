// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "../libraries/LoanLibrary.sol";

import "./IPromissoryNote.sol";
import "./IFeeController.sol";
import "./ILoanCore.sol";

/**
 * @dev Interface for the LoanCore contract
 */
interface ILoanCore {
    /**
     * @dev Emitted when a loan is initially created
     */
    event LoanCreated(LoanLibrary.LoanTerms terms, uint256 loanId);

    /**
     * @dev Emitted when a loan is started and principal is distributed to the borrower.
     */
    event LoanStarted(uint256 loanId, address lender, address borrower);

    /**
     * @dev Emitted when a loan is repaid by the borrower
     */
    event LoanRepaid(uint256 loanId);

    /**
     * @dev Emitted when an installment payment is made that does not pay off the loan entirely
     */
    event InstallmentPaymentReceived(uint256 loanId, uint256 repaidAmount, uint256 remBalance);

    /**
     * @dev Emitted when a loan collateral is claimed by the lender
     */
    event LoanClaimed(uint256 loanId);

    /**
     * @dev Emitted when fees are claimed by admin
     */
    event FeesClaimed(address token, address to, uint256 amount);

    event NonceUsed(address indexed user, uint160 nonce);

    /**
     * @dev Get LoanData by loanId
     */
    function getLoan(uint256 loanId) external view returns (LoanLibrary.LoanData calldata loanData);

    /**
     * @dev Create store a loan object with some given terms
     */
    function createLoan(LoanLibrary.LoanTerms calldata terms) external returns (uint256 loanId);

    /**
     * @dev Start a loan with the given borrower and lender
     *  Distributes the principal less the protocol fee to the borrower
     *
     * Requirements:
     *  - This function can only be called by a whitelisted OriginationController
     *  - The proper principal and collateral must have been sent to this contract before calling.
     */
    function startLoan(
        address lender,
        address borrower,
        uint256 loanId
    ) external;

    /**
     * @dev Repay the given loan
     *
     * Requirements:
     *  - The caller must be a holder of the borrowerNote
     *  - The caller must send in principal + interest
     *  - The loan must be in state Active
     */
    function repay(uint256 loanId) external;

    /**
     * @dev Repay the given loan
     *
     * Requirements:
     *  - The caller must be a holder of the borrowerNote
     *  - The caller must send in at least minimum payment amount
     *  - The loan must be in state Active and have number of Installments greater than 0
     */
    function repayPart(
        uint256 _loanId,
        uint256 _currentMissedPayments,
        uint256 _paymentToPrincipal,
        uint256 _paymentToInterest,
        uint256 _paymentToLateFees
    ) external;

    /**
     * @dev Claim the collateral of the given delinquent loan
     *
     * Requirements:
     *  - The caller must be a holder of the lenderNote
     *  - The loan must be in state Active
     *  - The current time must be beyond the dueDate
     */
    function claim(uint256 loanId) external;

    function consumeNonce(address user, uint160 nonce) external;

    function cancelNonce(uint160 nonce) external;

    /**
     * @dev Getters for integrated contracts
     *
     */
    function borrowerNote() external returns (IPromissoryNote);

    function lenderNote() external returns (IPromissoryNote);

    function feeController() external returns (IFeeController);
}
